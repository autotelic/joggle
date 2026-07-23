import { defineRule } from "@oxlint/plugins";
import type { Context } from "@oxlint/plugins";

type FunctionLike = {
  node: any;
  name: string;
};

function fingerprint(node: any, idMap: Map<string, number>): string {
  if (!node || typeof node !== "object") return "nil";

  if (Array.isArray(node)) {
    return `[${node.map((n) => fingerprint(n, idMap)).join(",")}]`;
  }

  const t = node.type;

  if (
    t === "Identifier" ||
    t === "PrivateIdentifier" ||
    t === "JSXIdentifier"
  ) {
    const name: string = node.name;
    if (!idMap.has(name)) idMap.set(name, idMap.size);
    return `$${idMap.get(name)}`;
  }

  if (t === "Literal") {
    const v = node.value;
    if (typeof v === "string") return `str`;
    if (typeof v === "number") return `num`;
    if (typeof v === "boolean") return `bool`;
    if (v === null) return `null`;
    if (typeof v === "bigint") return `bigint`;
    if (v instanceof RegExp || node.regex) return `re`;
    return `lit`;
  }

  if (t === "TemplateElement") {
    return `template-element`;
  }

  const parts: string[] = [t];

  const skip = new Set([
    "parent",
    "start",
    "end",
    "loc",
    "range",
    "type",
    "raw",
    "value",
    "decorators",
    "comments",
    "tokens",
  ]);

  for (const key of Object.keys(node)) {
    if (skip.has(key)) continue;
    const val = node[key];
    if (val === null || val === undefined) continue;
    if (typeof val === "object" || Array.isArray(val)) {
      parts.push(`${key}:${fingerprint(val, idMap)}`);
    } else if (typeof val === "string" || typeof val === "boolean") {
      parts.push(`${key}:${String(val)}`);
    }
  }

  return parts.join("|");
}

function resolveName(node: any): string {
  const t = node.type ?? "";

  const id = node.id;
  if (id && id.name) return id.name;

  const parent = node.parent;
  if (!parent) return `<${t.toLowerCase()} L${node.loc?.start?.line ?? "?"}>`;

  // Arrow assigned to a variable
  if (
    t === "ArrowFunctionExpression" &&
    (parent.type === "VariableDeclarator" || parent.type === "Property")
  ) {
    if (parent.id?.name) return parent.id.name;
    if (parent.key?.name) return `#${parent.key.name}`;
  }

  // Method in a class
  if (
    t === "FunctionExpression" &&
    parent.type === "MethodDefinition"
  ) {
    if (parent.key?.name) return `#${parent.key.name}`;
    if (parent.key?.value) return `#[${parent.key.value}]`;
  }

  // Object method shorthand
  if (t === "FunctionExpression" && parent.type === "Property") {
    if (parent.key?.name) return `#${parent.key.name}`;
  }

  // Callback in a call expression -- show line number
  const line = node.loc?.start?.line;
  return `<${t.toLowerCase()} L${line ?? "?"}>`;
}

function findFunctions(node: any, results: FunctionLike[], depth: number): void {
  if (!node || typeof node !== "object") return;

  const t = node.type;

  if (
    t === "FunctionDeclaration" ||
    t === "FunctionExpression" ||
    t === "ArrowFunctionExpression"
  ) {
    const name = resolveName(node);
    if (
      t === "FunctionDeclaration" ||
      t === "FunctionExpression"
    ) {
      if (node.body && node.body.type === "BlockStatement") {
        results.push({ node: node.body, name });
      }
    } else if (t === "ArrowFunctionExpression") {
      if (node.body) {
        results.push({
          node: node.body.type === "BlockStatement" ? node.body : node,
          name,
        });
      }
    }
  }

  const skip = new Set(["parent"]);
  for (const key of Object.keys(node)) {
    if (skip.has(key)) continue;
    const val = node[key];
    if (typeof val === "object") {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === "object" && item.type) {
            findFunctions(item, results, depth + 1);
          }
        }
      } else if (val && val.type) {
        findFunctions(val, results, depth + 1);
      }
    }
  }
}

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Detect structurally identical function implementations and suggest collapsing them.",
    },
    messages: {
      duplicate:
        "Duplicate implementation detected. '{{dupe}}' has the same structure as '{{original}}'. Consider extracting a shared utility.",
    },
  },
  create(context: Context) {
    return {
      "Program:exit"(node: any) {
        const funcs: FunctionLike[] = [];
        findFunctions(node, funcs, 0);

        const byFingerprint = new Map<string, FunctionLike[]>();

        for (const f of funcs) {
          const idMap = new Map<string, number>();
          const fp = fingerprint(f.node, idMap);
          const existing = byFingerprint.get(fp);
          if (existing) {
            existing.push(f);
          } else {
            byFingerprint.set(fp, [f]);
          }
        }

        for (const [, copies] of byFingerprint) {
          if (copies.length < 2) continue;

          const original = copies[0];
          for (let i = 1; i < copies.length; i++) {
            const dupe = copies[i];
            context.report({
              node: dupe.node,
              messageId: "duplicate",
              data: {
                dupe: dupe.name,
                original: original.name,
              },
            });
          }
        }
      },
    };
  },
});

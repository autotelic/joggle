import { definePlugin } from "@oxlint/plugins";
import entropyMachine from "./rules/entropy.js";

export default definePlugin({
  meta: { name: "entropy" },
  rules: { "entropy-machine": entropyMachine },
});

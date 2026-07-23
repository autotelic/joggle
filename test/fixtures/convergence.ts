// ─── Functions that ARE exact duplicates ───
function add(a: number, b: number): number {
  return a + b;
}

function sum(x: number, y: number): number {
  return x + y;
}

// ─── Callers — these become duplicates AFTER collapsing add→sum ───
function calculateTotal(price: number, tax: number): number {
  return add(price, tax); // calls add — after collapse, this IS sum
}

function computePrice(base: number, tax: number): number {
  return sum(base, tax); // calls sum
}

// ─── Another exact duplicate pair ───
function multiply(a: number, b: number): number {
  return a * b;
}

function times(x: number, y: number): number {
  return x * y;
}

// ─── These callers ALSO converge after collapsing multiply→times ───
function areaCalc(width: number, height: number): number {
  const base = multiply(width, height);
  return base + 10;
}

function rectSize(w: number, h: number): number {
  const val = times(w, h);
  return val + 10;
}

// ─── NOT duplicates — different structure ───
function divide(a: number, b: number): number {
  if (b === 0) return 0;
  return a / b;
}

function uniqueCalc(x: number): number {
  return x * x + 2;
}

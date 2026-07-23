// DUPLICATE: these two functions do the same thing
function sum(a: number, b: number): number {
  return a + b;
}

function add(x: number, y: number): number {
  return x + y;
}

// DUPLICATE: these arrow functions do the same thing after identifier normalization
const doubleCount = (items: number[]): number[] => {
  return items.map((item: number) => item * 2);
};

const multiplyByTwo = (arr: number[]): number[] => {
  return arr.map((el: number) => el * 2);
};

// DUPLICATE: same interface shape
interface User {
  id: number;
  name: string;
  email: string;
}

interface Person {
  id: number;
  name: string;
  email: string;
}

// DUPLICATE: same JSX structure
const CardA = () => (
  <div className="card">
    <h2>Title</h2>
    <p>Description</p>
  </div>
);

const CardB = () => (
  <div className="card">
    <h2>Different title</h2>
    <p>Another description</p>
  </div>
);

// NOT a duplicate — different structure
function fetchData(url: string): string {
  return url.toUpperCase();
}

function uniqueOne(x: string | null): number {
  return x && x.length;
}

function uniqueTwo(x: string | null): number {
  if (!x) return 0;
  return x.length;
}

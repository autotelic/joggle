// DUPLICATE: these two functions do exactly the same thing
function sum(a, b) {
  return a + b;
}

function add(x, y) {
  return x + y;
}

// DUPLICATE: these arrow functions are identical save for variable renaming
const doubleCount = (items) => {
  return items.map(item => item * 2);
};

const multiplyByTwo = (arr) => {
  return arr.map(el => el * 2);
};

// DUPLICATE: methods with same body
class User {
  getFullName(f, l) {
    return f + " " + l;
  }
}

class Person {
  getDisplayName(first, last) {
    return first + " " + last;
  }
}

// NOT a duplicate — different structure
function fetch(url) {
  return url.toUpperCase();
}

// NOT a duplicate — one has extra logic
function unique1(x) {
  return x && x.length;
}

function unique2(x) {
  if (!x) return 0;
  return x.length;
}

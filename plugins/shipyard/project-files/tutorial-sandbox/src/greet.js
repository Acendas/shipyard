/** A greeting for a person, with a default when no name is given. */
export function greet(name) {
  const who = typeof name === "string" && name.trim() ? name.trim() : "there";
  return `Hello, ${who}!`;
}

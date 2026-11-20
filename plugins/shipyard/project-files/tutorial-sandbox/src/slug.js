/** A URL slug for a title: lower case, words joined by single hyphens. */
export function slugify(title) {
  // TODO: an empty title and a title that is not a string are not handled yet
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The total of an order: each item has a price and a quantity. */
export function total(items) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  let sum = 0;
  for (const item of items) {
    const price = Number(item?.price);
    const quantity = Number(item?.quantity ?? 1);
    if (!Number.isFinite(price) || price < 0) throw new RangeError(`bad price: ${item?.price}`);
    if (!Number.isInteger(quantity) || quantity < 0) throw new RangeError(`bad quantity: ${item?.quantity}`);
    sum += price * quantity;
  }
  return Math.round(sum * 100) / 100;
}

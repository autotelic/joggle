import { formatDollar } from "../utils/money"

export function Total({ amount }: { amount: number }) {
  return <span>${amount.toFixed(2)}</span>
}

export function Correct({ amount }: { amount: number }) {
  return <span>{formatDollar(amount)}</span>
}

export interface Payroll {
  useSwaDayRate: boolean
  pieceRatePay: number
  swaPayTotal: number
}

export function isDayRate(payroll: Payroll): boolean {
  return payroll.pieceRatePay + payroll.swaPayTotal > 0
}

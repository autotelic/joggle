export interface Row {
  id: string
  total: number
}

export function normalise(row: Row): Row {
  return row
}

export function validate(row: Row): Row {
  return row
}

export function save(row: Row): Row {
  return row
}

/** The primitive: one name for the three calls in order. */
export function cleanRow(row: Row): Row {
  return save(validate(normalise(row)))
}

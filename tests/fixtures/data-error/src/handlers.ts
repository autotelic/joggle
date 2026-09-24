/**
 * A handler that reads a row and answers 5xx when it is not there.
 *
 * The lookup is a call whose name says it reads a row; the guard is `!row`; the
 * status is 500. All three are syntax, so the candidate is deterministic and the
 * question is only whether an absent row here is normal or a broken invariant.
 */
export async function getProject(reply, id) {
  const row = await db.findById(id)
  if (!row) {
    return reply.code(500).send("missing")
  }
  return reply.send(row)
}

/** The same shape with a 404: the guard meets no 5xx, so it is not a candidate. */
export async function getProjectOk(reply, id) {
  const row = await db.findById(id)
  if (!row) {
    return reply.code(404).send("not found")
  }
  return reply.send(row)
}

/** The assignment form of the status, and the `=== null` form of the guard. */
export async function getCrew(res, id) {
  const crew = await crewStore.fetchOne(id)
  if (crew === null) {
    res.statusCode = 503
    return
  }
  res.send(crew)
}

/** A lookup that is read but never guarded: not a candidate. */
export async function listProjects(reply, id) {
  const rows = await projectStore.fetchAll(id)
  reply.code(500).send(rows)
}

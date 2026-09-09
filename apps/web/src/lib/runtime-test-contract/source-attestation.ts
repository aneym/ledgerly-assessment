export type SourceIdentity = { revision: string; dirty: boolean };

/** The runtime owner supplies the revision captured with the loaded application code.
 * readSource must inspect that same source tree or immutable build manifest, never QA_TARGET_SHA.
 * This factory compares evidence; it cannot authenticate an untrusted evidence supplier. */
export async function createSourceAttestation(deps: {
  loadedRevision: string;
  targetRevision: string;
  readSource(): Promise<SourceIdentity>;
}) {
  const { loadedRevision, targetRevision, readSource } = deps;
  const verify = async () => {
    const actual = await readSource();
    if (
      !/^[a-f0-9]{40}$/.test(loadedRevision) ||
      !/^[a-f0-9]{40}$/.test(targetRevision) ||
      actual.dirty !== false ||
      actual.revision !== loadedRevision ||
      targetRevision !== loadedRevision
    )
      throw new Error("source_revision_mismatch");
    return Object.freeze({ source_revision: loadedRevision });
  };
  await verify();
  return Object.freeze({ read: verify });
}

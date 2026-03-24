/**
 * Convert an Aleo program name (without .aleo suffix) to its field encoding.
 *
 * In snarkVM, `Identifier::to_field()` interprets the UTF-8 bytes of the
 * name as a little-endian integer. This is the value that `_dynamic_call`
 * uses to identify the target program at runtime.
 *
 * Example: identifierToField("toka") => "1634430836field"
 */
export function identifierToField(name: string): string {
  const bytes = new TextEncoder().encode(name);
  let result = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    result |= BigInt(bytes[i]) << (BigInt(i) * 8n);
  }
  return result.toString() + "field";
}

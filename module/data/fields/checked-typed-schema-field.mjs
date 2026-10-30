/**
 * A TypedSchemaField whose variant is really checked when the field is validated as part of its
 * parent (Decisions ADR-020, Step 4.4 S1 Quench finding).
 *
 * In Foundry 14.369, TypedSchemaField#_validateType validates the value against its variant's
 * schema and returns the resulting failure instead of throwing it (common/data/fields.mjs
 * 4611-4619). The validator loop only acts on a thrown error or on a `true` or `false` result, so a
 * returned failure is ignored (442-455). Parents always validate their children non-strictly
 * (SchemaField#_validateRecursive, 1306; DataModel#validate, common/abstract/data.mjs 605), so the
 * variant's failure is never thrown: on create, on world load and in a strict throwaway model only
 * the `type` is checked, and nothing inside the variant (die sizes, whole numbers, ids, choices).
 *
 * This subclass throws that failure, resolved or not, as SchemaField#_validateRecursive does with
 * its own, so the field fails like any other schema. It can go once Foundry throws the failure
 * itself; a Quench test in tests/quench/contest-model.mjs shows when that happens.
 * @module data/fields/checked-typed-schema-field
 */

export default class CheckedTypedSchemaField extends foundry.data.fields.TypedSchemaField {

  /**
   * Checks the type as TypedSchemaField does, then throws the variant's failure instead of
   * returning it.
   * @override
   * @param {unknown} value
   * @param {object} options
   * @returns {boolean|void} what TypedSchemaField#_validateType returns when there is no failure
   * @throws {foundry.data.validation.DataModelValidationFailure} the variant's failure
   */
  _validateType(value, options) {
    const result = super._validateType(value, options);
    if ( result instanceof foundry.data.validation.DataModelValidationFailure ) throw result;
    return result;
  }
}

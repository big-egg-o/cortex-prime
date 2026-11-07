/**
 * A BooleanField that refuses a value that isn't a boolean instead of converting it.
 *
 * In Foundry 14.369, BooleanField#_cast turns any value into a boolean while the data is cleaned,
 * before it is validated (common/data/fields.mjs: DataField#clean, BooleanField#_cast): "yes"
 * becomes false, 1 becomes true, an object becomes false. So a malformed flag, such as a trait's
 * `challenged`, would be stored silently as some boolean. This field keeps the value as given, so
 * BooleanField#_validateType refuses it, as the pure rules functions refuse it
 * (INVALID_TRAIT_DATA in module/rules/statements.mjs). `null` and `undefined` still take the
 * field's initial value, as for any field. Forms send real booleans for checkboxes, so sheets are
 * unaffected.
 * @module data/fields/strict-boolean-field
 */

export default class StrictBooleanField extends foundry.data.fields.BooleanField {

  /**
   * Keeps the value as given, so validation refuses anything that isn't a boolean.
   * @override
   * @param {unknown} value
   * @returns {unknown}
   */
  _cast(value) {
    return value;
  }
}

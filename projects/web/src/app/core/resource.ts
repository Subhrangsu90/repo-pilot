import type { Resource } from '@angular/core';

/**
 * The resource's value, or undefined while it loads or after it failed.
 * `resource.value()` throws when the resource is in an error state (e.g. the
 * API answered 401 or 502), and a throw inside a computed or a template stops
 * the whole view from updating. Read resources through this, or check
 * `hasValue()` first.
 */
export function valueOf<T>(resource: Resource<T | undefined>): T | undefined {
  return resource.hasValue() ? resource.value() : undefined;
}

/**
 * This works around some old node-style code in a
 * dependency of box-intersect.
 */
if (window && !(window as any)["global"]) {
  (window as any)["global"] = window.globalThis || {};
}

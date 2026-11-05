import { createHashHistory } from '@tanstack/react-router'

/**
 * Single-file build: a `file://` page has no usable pathname base, so routes live in the hash
 * (`8sme-tools.html#/preflight`) where navigation and refresh both work offline.
 */
export const appHistory = createHashHistory()

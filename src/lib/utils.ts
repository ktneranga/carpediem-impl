import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * tailwind-merge cannot see this project's custom @theme tokens, so it classifies
 * by class name alone. `text-fs-16` looks exactly like `text-slate-900` to it —
 * both are `text-*` — so the two landed in the same conflict group and whichever
 * came last won. In practice that silently deleted every font size that shared a
 * cn() call with a text colour, across the table cards, zone chips, context
 * header and PIN pad. Nothing errored; the type scale simply never reached the
 * screen.
 *
 * Registering the custom scales restores the intended behaviour: a size and a
 * colour are independent, and only two sizes conflict with each other.
 *
 * Any new `--text-*`, `--shadow-*` or `--inset-shadow-*` token whose name is not
 * a plain t-shirt size must be added here too.
 */
const isFontSizeToken = (value: string) => /^fs-\d+$/.test(value)

const twMerge = extendTailwindMerge({
  override: {
    classGroups: {
      // Both of these must be overridden together. tailwind-merge's stock
      // `text-color` validator accepts ANY value, and it is consulted before
      // anything added via `extend` — so merely registering the font sizes is
      // not enough, `text-color` has to stop claiming them.
      "font-size": [{ text: [isFontSizeToken] }],
      "text-color": [{ text: [(value: string) => !isFontSizeToken(value)] }],
    },
  },
  extend: {
    classGroups: {
      // --shadow-el-1 … --shadow-el-4, plus the named states
      shadow: [{ shadow: [(value: string) => /^el-\d$/.test(value), "selected", "pressed"] }],
      // --inset-shadow-top. Its own group, so it composes with a shadow-*
      // instead of overwriting it.
      "inset-shadow": [{ "inset-shadow": ["top"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

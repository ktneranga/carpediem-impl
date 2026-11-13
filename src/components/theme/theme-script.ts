/**
 * The theme's storage keys and the pre-paint script. A plain module (no
 * 'use client') so the server's root layout can read the string itself.
 */

export const THEME_KEY = 'cdrms-theme'
/** Where Manage kept it before the app-wide setting (read as a fallback). */
export const OLD_THEME_KEY = 'cdrms-manage-theme'

/**
 * Runs in <head> before the page draws, so a dark device never flashes white
 * on a full page load. Same rule as `useTheme`; any failure leaves it light.
 */
export const THEME_SCRIPT = `try{var c=localStorage.getItem('${THEME_KEY}')||localStorage.getItem('${OLD_THEME_KEY}');var d=c==='dark'||(c!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.setAttribute('data-theme','night')}catch(e){}`

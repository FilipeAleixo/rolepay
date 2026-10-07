/**
 * Lora (headings and big numerals) and Montserrat (everything else), the product's two families.
 * Both are under the SIL Open Font License 1.1, which allows embedding them in a video. Remotion
 * does not see the app's own font files, so they are registered here; renders would fall back to
 * system fonts otherwise.
 */
import { loadFont as loadLora } from '@remotion/google-fonts/Lora'
import { loadFont as loadMontserrat } from '@remotion/google-fonts/Montserrat'

const lora = loadLora('normal', { weights: ['400', '500'], subsets: ['latin'] })
loadLora('italic', { weights: ['400'], subsets: ['latin'] })

const montserrat = loadMontserrat('normal', { weights: ['400', '500', '600'], subsets: ['latin'] })

export const SERIF = `${lora.fontFamily}, Georgia, serif`
export const SANS = `${montserrat.fontFamily}, system-ui, sans-serif`

// Buttons take their font size from the row they sit in: globals.css's unlayered `font: inherit` makes one on the button inert.
export const TEXT_BUTTON = 'inline-flex items-center justify-center gap-1.5 py-1 text-foreground-secondary hover:text-foreground'
export const PRIMARY_BUTTON = 'inline-flex min-h-8 shrink-0 items-center justify-center gap-[7px] border border-primary bg-primary px-2.5 py-1.5 text-primary-foreground not-disabled:hover:opacity-80 disabled:opacity-40 [&_svg]:size-[13px]'
export const SPINNER = 'inline-block size-[13px] shrink-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent [animation-duration:.75s] motion-reduce:animate-none'
export const STATUS_DOT = 'size-1.5 shrink-0 rounded-full bg-current pulse-dot'
// One focus outline for every control inside; outline-none (upstream controls, the composer) opts out.
export const FOCUS_OUTLINE = '[&_:focus-visible]:outline-2 [&_:focus-visible]:outline-offset-2 [&_:focus-visible]:outline-ring'

function horizontalPx(style: CSSStyleDeclaration, ...properties: string[]): number {
  return properties.reduce(
    (sum, property) => sum + (Number.parseFloat(style.getPropertyValue(property)) || 0),
    0
  )
}

/** Width the left titlebar row needs once the app name, its only shrinkable control, is squeezed to its padding. */
export function measureTitlebarLeftMinWidth(row: HTMLElement): number {
  let width = 0
  for (const child of row.children) {
    if (!(child instanceof HTMLElement)) {
      continue
    }
    // scrollWidth keeps content that overflows a shrunk group; left margins are auto free space, not need.
    width +=
      Math.max(child.scrollWidth, child.getBoundingClientRect().width) +
      horizontalPx(getComputedStyle(child), 'margin-right')
  }
  const appName = row.querySelector('.titlebar-app-name')
  if (appName instanceof HTMLElement) {
    width -=
      appName.getBoundingClientRect().width -
      horizontalPx(
        getComputedStyle(appName),
        'padding-left',
        'padding-right',
        'border-left-width',
        'border-right-width'
      )
  }
  return Math.ceil(width)
}

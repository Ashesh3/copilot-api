import type { CSSProperties, ReactNode } from "react"

interface ResponsivePairStyle extends CSSProperties {
  "--responsive-pair-min": string
}

export interface ResponsivePairProps {
  children: ReactNode
  minWidth: number
}

export function ResponsivePair({ children, minWidth }: ResponsivePairProps) {
  const style: ResponsivePairStyle = {
    "--responsive-pair-min": `${minWidth}px`,
  }

  return (
    <div className="responsive-pair" style={style}>
      {children}
    </div>
  )
}

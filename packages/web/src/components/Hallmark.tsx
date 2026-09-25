import type { CSSProperties, ElementType, ReactNode } from "react";

type HallmarkProps = {
  children: ReactNode;
  tone?: "gold" | "quiet";
  size?: "md" | "lg";
  // The inner layer must match whatever the mark sits on, or the 1px edge turns into a filled box.
  ground?: string;
  as?: ElementType;
  className?: string;
};

export function Hallmark({ children, tone = "gold", size = "md", ground, as: Tag = "span", className = "" }: HallmarkProps) {
  const style = ground ? ({ "--hm-ground": ground } as CSSProperties) : undefined;
  const classes = ["hallmark", tone === "quiet" && "hallmark-quiet", size === "lg" && "hallmark-lg", className]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag className={classes} style={style}>
      {children}
    </Tag>
  );
}

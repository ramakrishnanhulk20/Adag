import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary";

type CommonProps = {
  variant?: Variant;
  // "sm" is the 40px nav size; everything else is 48px.
  size?: "md" | "sm";
  children: ReactNode;
  className?: string;
  // Only the lab uses this, to show a hover or focus state without a pointer or keyboard.
  forceState?: "hover" | "focus";
};

type AsButton = CommonProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & { href?: undefined };
type AsLink = CommonProps & { href: string; disabled?: boolean; external?: boolean };

export type ButtonProps = AsButton | AsLink;

function classNames({ variant = "primary", size = "md", className = "", forceState }: CommonProps) {
  return ["btn", `btn-${variant}`, size === "sm" && "btn-sm", forceState === "hover" && "is-hover", forceState === "focus" && "is-focus", className]
    .filter(Boolean)
    .join(" ");
}

export function Button(props: ButtonProps) {
  if (props.href !== undefined) {
    const { href, disabled, external, children } = props;
    const classes = classNames(props);
    if (disabled) {
      return (
        <a role="link" aria-disabled="true" className={classes}>
          {children}
        </a>
      );
    }
    if (external) {
      return (
        <a href={href} className={classes} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    }
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }

  const { variant: _variant, size: _size, className: _className, forceState: _forceState, children, type = "button", ...rest } = props;
  return (
    <button type={type} className={classNames(props)} {...rest}>
      {children}
    </button>
  );
}

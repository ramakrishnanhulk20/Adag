import { Button } from "@/components/Button";

type HeroActionProps = {
  href: string;
  variant: "primary" | "secondary";
  size?: "md" | "sm";
  children: React.ReactNode;
  // Carries the display value too (for example "hidden md:inline-flex"), so a caller can hide it at some widths.
  className?: string;
};

export function HeroAction({ href, variant, size = "md", children, className = "" }: HeroActionProps) {
  return (
    <Button href={href} variant={variant} size={size} className={className}>
      {children}
    </Button>
  );
}

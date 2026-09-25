export function DiamondSeparator({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`diamond ${className}`} />;
}

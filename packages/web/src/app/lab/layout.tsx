import { notFound } from "next/navigation";

// The lab is the design workbench: useful on a dev server, never shipped. Production answers 404 for every /lab page.
export default function LabLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();
  return children;
}

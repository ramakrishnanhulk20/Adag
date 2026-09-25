import { redirect } from "next/navigation";

// The landing page arrives with the hero work order; until then the root sends Ram to the lab.
export default function Home() {
  redirect("/lab");
}

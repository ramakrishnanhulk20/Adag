"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/Button";

type ShareActionsProps = {
  url: string;
  title: string;
  text: string;
  size?: "md" | "sm";
  className?: string;
};

// The phone's own share sheet where the browser has one (one tap to WhatsApp, Mail or Messages), and Copy link always.
export function ShareActions({ url, title, text, size = "md", className = "" }: ShareActionsProps) {
  const [canShare, setCanShare] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title, text, url });
    } catch {
      // Closing the share sheet is not an error worth showing.
    }
  };

  return (
    <div className={`flex flex-col gap-3 md:flex-row ${className}`}>
      {canShare && (
        <Button variant="primary" size={size} onClick={() => void share()} className="w-full md:w-auto" data-action="share">
          Send the bill
        </Button>
      )}
      <Button variant={canShare ? "secondary" : "primary"} size={size} onClick={() => void copy()} className="w-full md:w-auto" data-action="copy-link">
        {copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}

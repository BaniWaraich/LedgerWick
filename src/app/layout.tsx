import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Muneem Ji",
  description: "Invoice-to-bank-transaction reconciliation",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

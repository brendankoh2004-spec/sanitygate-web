import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SanityGate — check what your AI actually wrote',
  description: 'SanityGate checks AI-generated content against its source and requirements, highlights what doesn\'t align, and shows you what to change.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

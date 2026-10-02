import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Tabs',
  description: 'Shared expenses for friends, flatmates and trips.',
};

/**
 * The root document. No session access and no database: this layout is shared by /sign-in and
 * /sign-up, and a signed-out visitor must not pay for the shell.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-bg text-text font-body">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-space-2 focus:top-space-2 focus:z-10 focus:bg-surface focus:px-space-3 focus:py-space-2"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
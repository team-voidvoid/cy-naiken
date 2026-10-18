import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'ナイケン — 預ける前に、内見を。',
  description: 'Webサービスの公開情報を点検し、個人情報を預ける前の判断材料を届けます。根拠を示し、分からないことも正直に。',
  icons: { icon: '/favicon.svg', shortcut: '/favicon.svg' },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ja"><body>{children}</body></html>; }

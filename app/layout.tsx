import type { Metadata } from 'next';
import { Inter, Outfit } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
import { ThemeProvider } from '@/components/providers/theme-provider';
import { ConfirmProvider } from '@/components/providers/confirm-provider';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';
import './globals.css';

const inter = Inter({
  variable: '--font-sans',
  subsets: ['latin'],
  display: 'swap',
});

const outfit = Outfit({
  variable: '--font-heading',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Exped',
  description: 'Sistema de pedidos e logística',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Avaliado por-request (runtime do servidor), não na carga do módulo, para que o
  // resolvedor leia SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL no momento da chamada
  // (Turbopack não assa NEXT_PUBLIC_* nos chunks). O resultado é injetado em
  // window.__SUPABASE_* para o cliente do browser (lib/supabase/client.ts).
  const supabaseConfig = {
    url: supabaseUrl(),
    anonKey: supabaseAnonKey(),
  };

  return (
    <html
      lang="pt-BR"
      className={`${inter.variable} ${outfit.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <script
        dangerouslySetInnerHTML={{
          __html: `window.__SUPABASE_URL__=${JSON.stringify(supabaseConfig.url)};window.__SUPABASE_ANON_KEY__=${JSON.stringify(supabaseConfig.anonKey)};`,
        }}
      />
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
          <ConfirmProvider>
            {children}
            <Toaster position="top-right" richColors closeButton />
          </ConfirmProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

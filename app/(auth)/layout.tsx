export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-franzoni-navy-50 via-background to-franzoni-orange-50 p-4">
      {children}
    </div>
  );
}

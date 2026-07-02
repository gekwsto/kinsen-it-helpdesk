import { BackgroundRippleEffect } from "@/components/ui/background-ripple-effect";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark relative min-h-screen w-full flex items-center justify-center overflow-hidden bg-slate-950">
      <BackgroundRippleEffect />
      <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
        <div className="pointer-events-auto px-4">
          {children}
        </div>
      </div>
    </div>
  );
}

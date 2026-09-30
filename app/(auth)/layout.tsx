/* eslint-disable @next/next/no-img-element */

/**
 * Sign-in frame: a navy brand field carrying the official white logo and the
 * K mark's lower teal triangle at page scale (its one authored shape, the
 * same one the app uses as the "current place" notch), beside a plain
 * working panel. The panel follows the user's light/dark preference; the
 * brand field is navy in both.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen w-full bg-background lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <aside className="relative flex min-h-[200px] flex-col overflow-hidden bg-brand-navy px-6 py-6 text-white lg:min-h-screen lg:px-12 lg:py-12">
        <img src="/kinsen_logo_white.webp" alt="Kinsen" className="relative z-10 -ml-3 h-20 w-20 object-contain lg:-ml-6 lg:h-40 lg:w-40" />
        <div className="relative z-10 mt-2 max-w-[62%] lg:mt-10 lg:max-w-md">
          <p className="text-2xl font-bold tracking-tight lg:text-4xl">IT Helpdesk</p>
          <p className="mt-2 text-sm text-[#C3D2DC] lg:text-base">
            Requests, projects and activities for everyone at Kinsen.
          </p>
        </div>
        {/* The K mark's teal triangle (base twice its height, apex up, as
            measured on public/kinsen_vertical.webp), scaled to the field. */}
        <span
          aria-hidden="true"
          className="absolute bottom-0 right-0 aspect-[2/1] w-[44%] translate-x-[14%] bg-brand-teal lg:w-[72%] lg:translate-x-[10%]"
          style={{ clipPath: "polygon(0 100%, 50% 0, 100% 100%)" }}
        />
      </aside>
      <main className="flex items-start justify-center px-6 py-10 lg:items-center lg:py-12">{children}</main>
    </div>
  );
}

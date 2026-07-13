import { Building2 } from 'lucide-react';
import ProfileMenu from './ProfileMenu';

/*
 * Header.jsx — the dark bar across the top of the page ("Pro Workstation" theme).
 * Left side: the clinic's logo and CHC name (from the signed-in account).
 * Right side: the profile menu (name + avatar), which holds Edit profile and Log out.
 *
 * Props:
 *   user       — the signed-in person { fullName, chcName, ... }
 *   onLogout   — called when the user confirms logging out (via the menu)
 *   onUpdated  — called with the updated user after an "Edit profile" save
 */
export default function Header({ user, onLogout, onUpdated }) {
  return (
    // "sticky top-0" keeps this bar pinned to the top of the screen while you scroll.
    <header className="sticky top-0 z-10 rail-dark border-b border-slate-800">
      {/* No max-width cap here — the CHC name and profile menu sit at the true
          left/right edges of the window (just inside the padding), instead of
          the edges of a centred content block on wide screens. */}
      <div className="w-full px-4 sm:px-8 h-16 flex items-center gap-3">
        {/* Indigo rounded square holding a building icon — the clinic logo */}
        <div className="w-10 h-10 rounded-[11px] bg-indigo-600 flex items-center justify-center shrink-0">
          <Building2 className="w-5 h-5 text-white" />
        </div>

        {/* CHC name (from the signed-in account) and subtitle */}
        <div className="min-w-0">
          <h1 className="text-base sm:text-lg font-bold tracking-tight text-white leading-tight truncate">
            {user?.chcName || 'CHC'}
          </h1>
          <p className="mono text-[11px] text-slate-500">patient intake portal</p>
        </div>

        {/* Far right: the profile menu (avatar → Edit profile / Log out). */}
        <div className="ml-auto">
          <ProfileMenu user={user} onLogout={onLogout} onUpdated={onUpdated} />
        </div>
      </div>
    </header>
  );
}

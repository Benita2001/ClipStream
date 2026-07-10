import Link from "next/link";
import styles from "./RoleNav.module.css";

/**
 * Two-tab Profile/Campaigns nav, shared shape across both roles so a
 * clipper or organizer can always get from one of their two pages to the
 * other. Clipper's "Campaigns" tab goes to the real browse list
 * (app/clipper/campaigns). Organizer has no separate browse list — an
 * organizer only ever sees campaigns *they* created, which already live in
 * a "Your campaigns" section on the Profile page — so Organizer's
 * "Campaigns" tab links to that section directly (`/organizer/profile#your-campaigns`)
 * rather than duplicating the list on its own route.
 */
export default function RoleNav({
  role,
  active,
}: {
  role: "clipper" | "organizer";
  active: "profile" | "campaigns";
}) {
  const profileHref = `/${role}/profile`;
  const campaignsHref = role === "clipper" ? "/clipper/campaigns" : "/organizer/profile#your-campaigns";

  return (
    <nav className={styles.nav}>
      <Link href={profileHref} className={active === "profile" ? styles.tabActive : styles.tab}>
        Profile
      </Link>
      <Link href={campaignsHref} className={active === "campaigns" ? styles.tabActive : styles.tab}>
        Campaigns
      </Link>
    </nav>
  );
}

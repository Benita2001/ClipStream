import Link from "next/link";
import styles from "./Header.module.css";

export default function Header() {
  return (
    <header className={styles.header}>
      <div className={styles.wrap}>
        <span className={styles.wordmark}>ClipStream</span>
        <nav className={styles.nav}>
          <div className={styles.navLinks}>
            <a href="#unique-features" className={styles.link}>
              Features
            </a>
            <a href="#how-it-works" className={styles.link}>
              How it works
            </a>
            <Link href="/clipper/profile" className={styles.link}>
              Log in
            </Link>
          </div>
          <a href="#choose-path" className={`btn ${styles.cta}`}>
            Get started
          </a>
        </nav>
      </div>
    </header>
  );
}

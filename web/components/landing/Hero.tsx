import styles from "./Hero.module.css";
import { heroHeight } from "@/lib/theme";

export default function Hero() {
  return (
    <section className={styles.hero} style={{ minHeight: heroHeight }}>
      <div className={styles.overlay} />
      <div className={styles.content}>
        <span className={styles.brandLabel}>ClipStream</span>
        <h1 className={styles.headline}>Your clips get paid per view.</h1>
        <p className={styles.lede}>
          No CPM thresholds. No payout minimums. Clippers earn as views accrue. Organizers see
          exactly where every dollar goes.
        </p>
        <a href="#choose-path" className={`btn ${styles.cta}`}>
          Get started
        </a>
      </div>
    </section>
  );
}

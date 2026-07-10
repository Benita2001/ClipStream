import styles from "./Footer.module.css";

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.wrap}>
        <span className={styles.left}>ClipStream — Powered on Arc</span>
        <span className={styles.right}>Every payout traceable on-chain</span>
      </div>
    </footer>
  );
}

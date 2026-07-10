import styles from "./FeatureGrid.module.css";

const FEATURES = [
  {
    tone: "accent",
    title: "Continuous settlement",
    desc: "Your clips earn per view count, with no CPM limit and no minimum payment threshold.",
  },
  {
    tone: "dark",
    title: "Autonomous pacing agent",
    desc: "Budget shifts toward whichever clips are actually being watched, within the ceiling and caps you set.",
  },
  {
    tone: "dark",
    title: "On-chain payout trail",
    desc: "Every payout traces back to a real transaction on Arc, paid out in USDC.",
  },
  {
    tone: "accent",
    title: "Native USDC escrow",
    desc: "Campaigns fund directly in stablecoin. Rate ceilings and per-clip caps are enforced at the contract level, not by policy.",
  },
];

export default function FeatureGrid() {
  return (
    <section id="unique-features" className={styles.section}>
      <div className={styles.wrap}>
        <div className={styles.head}>
          <div className={styles.eyebrow}>What makes it different</div>
          <h2 className={styles.heading}>Built for money that moves as fast as attention does.</h2>
        </div>
        <div className={styles.grid}>
          {FEATURES.map((f) => (
            <div key={f.title} className={styles.card}>
              <div className={f.tone === "accent" ? styles.iconAccent : styles.iconDark} />
              <div className={styles.title}>{f.title}</div>
              <div className={styles.desc}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

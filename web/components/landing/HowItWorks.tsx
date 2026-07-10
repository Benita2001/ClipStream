import styles from "./HowItWorks.module.css";

const STEPS = [
  {
    no: "01",
    title: "Organizer funds a pool",
    desc: "Deposit native USDC into campaign escrow. Set a rate, a ceiling, and rules.",
  },
  {
    no: "02",
    title: "Clippers get paid per view",
    desc: "Submit a clip, earn continuously as its view count climbs. No thresholds.",
  },
  {
    no: "03",
    title: "An agent paces the spend",
    desc: "Budget shifts toward what's actually being watched, live, within your limits.",
  },
];

export default function HowItWorks() {
  return (
    <section id="how-it-works" className={styles.section}>
      <div className={styles.wrap}>
        <h2 className={styles.heading}>How it works</h2>
        <div className={styles.grid}>
          {STEPS.map((s) => (
            <div key={s.no}>
              <div className={styles.no}>{s.no}</div>
              <div className={styles.title}>{s.title}</div>
              <div className={styles.desc}>{s.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

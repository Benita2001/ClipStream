import Link from "next/link";
import styles from "./ChoosePath.module.css";

export default function ChoosePath() {
  return (
    <section id="choose-path" className={styles.section}>
      <div className={styles.wrap}>
        <h2 className={styles.heading}>Which side are you on?</h2>
        <div className={styles.grid}>
          <div className={styles.dark}>
            <div className={styles.eyebrow}>For clippers</div>
            <div className={styles.title}>Get paid as your clip gets watched</div>
            <p className={styles.desc}>
              Browse open campaigns, submit a tweet URL, and watch your earnings climb in real
              time — no threshold to clear.
            </p>
            <Link href="/clipper/profile" className={`btn ${styles.ctaAccent}`}>
              Clipper
            </Link>
          </div>
          <div className={styles.light}>
            <div className={styles.eyebrow}>For organizers</div>
            <div className={styles.titleDark}>Know exactly what you&rsquo;re paying for</div>
            <p className={styles.descDark}>
              Fund a pool, set your rate and rules, and watch the pacing agent shift spend toward
              what&rsquo;s actually working.
            </p>
            <Link href="/organizer/profile" className={`btn ${styles.ctaDark}`}>
              Organizer
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

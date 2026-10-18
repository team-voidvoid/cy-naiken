import DotMascot from './DotMascot';
import styles from './InspectionProgress.module.css';

type InspectionProgressProps = {
  label: string;
  detail?: string;
  paused?: boolean;
  className?: string;
};

/** A repeating scene indicates activity; its position is not a completion percentage. */
export default function InspectionProgress({ label, detail, paused = false, className = '' }: InspectionProgressProps) {
  return <div className={`inspection-progress ${styles.progress} ${className}`} data-paused={paused} role="status" aria-live="polite">
    <div className={styles.heading}><span className={styles.statusDot} aria-hidden="true"/><strong>{label}</strong></div>
    <div className={styles.scene} aria-hidden="true">
      <span className={styles.cloud}/><span className={styles.cloudSmall}/>
      <span className={styles.road}><span className={styles.trail}/></span>
      <span className={styles.start}/>
      <svg className={styles.house} viewBox="0 0 122 122" fill="none">
        <ellipse cx="65" cy="116" rx="54" ry="5" fill="#dce9d0"/>
        <path d="M88 35V15h13v32" fill="#d8e7cb" stroke="#83a96a" strokeWidth="2" strokeLinejoin="round"/>
        <path d="M20 47 66 12l45 35v67H20V47Z" fill="#fffef8" stroke="#83a96a" strokeWidth="2" strokeLinejoin="round"/>
        <path d="m10 49 56-42 55 42" stroke="#6aa441" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M18 54 66 18l47 36" stroke="#e1edcf" strokeWidth="3" strokeLinejoin="round"/>
        <rect x="29" y="63" width="17" height="23" rx="2" fill="#e6f0dc" stroke="#9bbb82" strokeWidth="2"/>
        <rect className={styles.window} x="86" y="63" width="17" height="23" rx="2" fill="#e6f0dc"/>
        <path d="M88 63h13a2 2 0 0 1 2 2v19a2 2 0 0 1-2 2H88a2 2 0 0 1-2-2V65a2 2 0 0 1 2-2ZM37.5 63v23M29 74.5h17M94.5 63v23M86 74.5h17" stroke="#9bbb82" strokeWidth="2"/>
        <path d="M51 114V73a3 3 0 0 1 3-3h24a3 3 0 0 1 3 3v41" fill="#657d4f" stroke="#78965e" strokeWidth="2"/>
        <path d="M48 115h36" stroke="#b2c99a" strokeWidth="3" strokeLinecap="round"/>
        <circle cx="66" cy="43" r="7" fill="#eef5e4" stroke="#9bbb82" strokeWidth="2"/>
        <path d="M66 36v14M59 43h14" stroke="#9bbb82" strokeWidth="1.5"/>
        <path d="M10 113v-12m-5 5 5 3 5-7M109 113v-12m-5 5 5 3 5-7" stroke="#8ab966" strokeWidth="2" strokeLinecap="round"/>
      </svg>
      <div className={styles.lane}>
        <div className={styles.traveler}>
          <span className={styles.bubble}>おじゃまします</span>
          <span className={styles.shadow}/>
          <div className={styles.hop}><DotMascot className={styles.mascot}/></div>
        </div>
      </div>
      <svg className={styles.houseFront} viewBox="0 0 122 122" fill="none">
        <g className={styles.door}>
          <path d="M52 113V73a2 2 0 0 1 2-2h24a2 2 0 0 1 2 2v40H52Z" fill="#b5d592" stroke="#78965e" strokeWidth="2"/>
          <path d="M57 77h17v17H57Z" fill="#dcebc7" stroke="#94b678"/>
          <circle cx="74" cy="101" r="2" fill="#6e8d50"/>
        </g>
        <g className={styles.welcome} stroke="#d5ac48" strokeWidth="2" strokeLinecap="round">
          <path d="m85 39 3-5m6 13 6-1m-7 9 4 3"/>
        </g>
      </svg>
    </div>
    {detail && <p className={styles.detail}>{detail}</p>}
  </div>;
}

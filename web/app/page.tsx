import Header from "@/components/landing/Header";
import Hero from "@/components/landing/Hero";
import FeatureGrid from "@/components/landing/FeatureGrid";
import HowItWorks from "@/components/landing/HowItWorks";
import ChoosePath from "@/components/landing/ChoosePath";
import Footer from "@/components/landing/Footer";

export default function Home() {
  return (
    <>
      <Header />
      <Hero />
      <FeatureGrid />
      <HowItWorks />
      <ChoosePath />
      <Footer />
    </>
  );
}

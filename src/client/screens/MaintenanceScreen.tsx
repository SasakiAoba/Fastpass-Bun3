export function MaintenanceScreen() {
  return (
    <div className="screen centered-screen maintenance-screen">
      <section className="maintenance-card" aria-labelledby="maintenance-title">
        <h2 id="maintenance-title">営業停止中</h2>
        <p>現在、販売と入場受付は停止しています。管理画面から営業を再開してください。</p>
      </section>
    </div>
  );
}

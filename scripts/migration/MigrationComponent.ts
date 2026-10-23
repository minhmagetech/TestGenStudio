import
  {
    Component,
    component,
    subscribe,
    OnEntityStartEvent,
    ExecuteOn,
    MigrationService,
    MobileAppPlatform,
  } from 'meta/worlds';

@component()
export class MigrationComponent extends Component
{
  private migrationService = MigrationService.get();

  // Runs when the world starts on each player's device.
  @subscribe(OnEntityStartEvent, {execution: ExecuteOn.Everywhere})
  async onStart()
  {
    const platform = this.migrationService.getMobileAppPlatform();

    if(platform === MobileAppPlatform.MetaApps)
    {
      // Loop steps 1-2: the player is on Facebook or Instagram.
      // TODO: show your "Get the Horizon app" offer and call
      // onGetAppPressed() from its accept button.
    } else if(platform === MobileAppPlatform.MetaHorizon)
    {
      // Loop steps 4-5: the player is in the Meta Horizon app.
      await this.rewardIfMigrated();
    }
  }

  // Loop step 2: call this from your offer's accept button.
  async onGetAppPressed()
  {
    try
    {
      // true = the link reached the Meta app. The player now leaves your world.
      await this.migrationService.migrateToHorizonApp({
        migrationId: 'welcome_offer_v1', // optional: names this offer
      });
    } catch(err)
    {
      console.error('Migration failed:', err);
    }
  }

  // Loop steps 4-5: detect the returning player and reward them once.
  private async rewardIfMigrated()
  {
    try
    {
      const data = await this.migrationService.fetchMigrationData();
      // null = the check could not run. It does not mean "no migration".
      if(data?.hasUnrewardedMigration)
      {
        // TODO: grant your reward here (coins, an item, a badge...).
        await this.migrationService.setMigrationRewardGranted();
      }
    } catch(err)
    {
      console.error('Migration reward check failed:', err);
    }
  }
}
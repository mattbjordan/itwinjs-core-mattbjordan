/*---------------------------------------------------------------------------------------------
|  $Copyright: (c) 2018 Bentley Systems, Incorporated. All rights reserved. $
 *--------------------------------------------------------------------------------------------*/
import * as path from "path";
import { expect, assert } from "chai";
import { OpenMode, DbOpcode } from "@bentley/bentleyjs-core/lib/BeSQLite";
import { AccessToken, ChangeSet, IModel as HubIModel, MultiCode, CodeState } from "@bentley/imodeljs-clients";
import { Code } from "../../common/Code";
import { IModelVersion } from "../../common/IModelVersion";
import { KeepBriefcase } from "../BriefcaseManager";
import { IModelDb, ConcurrencyControl, ChangeSetDescriber } from "../IModelDb";
import { IModelTestUtils } from "./IModelTestUtils";
import { Id64 } from "@bentley/bentleyjs-core/lib/Id";
import { Element } from "../Element";
import { DictionaryModel } from "../Model";
import { SpatialCategory } from "../Category";
import { Appearance } from "../../common/SubCategoryAppearance";
import { ColorDef } from "../../common/ColorDef";
import { IModel } from "../../common/IModel";
import { IModelJsFs } from "../IModelJsFs";
import { iModelEngine } from "../IModelEngine";
import { AutoPush } from "../AutoPush";

let lastPushTimeMillis = 0;

class Timer {
  private label: string;
  constructor(label: string) {
    // tslint:disable-next-line:no-console
    console.time(this.label = "\t" + label);
  }

  public end() {
    // tslint:disable-next-line:no-console
    console.timeEnd(this.label);
  }
}

describe("BriefcaseManager", () => {
  let accessToken: AccessToken;
  let testProjectId: string;
  let testIModelId: string;
  let testChangeSets: ChangeSet[];
  const testVersionNames = ["FirstVersion", "SecondVersion", "ThirdVersion"];
  const testElementCounts = [80, 81, 82];

  let iModelLocalReadonlyPath: string;
  let iModelLocalReadWritePath: string;

  const getElementCount = (iModel: IModelDb): number => {
    const rows: any[] = iModel.executeQuery("SELECT COUNT(*) AS cnt FROM bis.Element");
    const count = +(rows[0].cnt);
    return count;
  };

  before(async () => {
    let startTime = new Date().getTime();
    console.log("    Started monitoring briefcase manager performance..."); // tslint:disable-line:no-console

    accessToken = await IModelTestUtils.getTestUserAccessToken();
    console.log(`    ...getting user access token from IMS: ${new Date().getTime() - startTime} ms`); // tslint:disable-line:no-console
    startTime = new Date().getTime();

    testProjectId = await IModelTestUtils.getTestProjectId(accessToken, "NodeJsTestProject");
    testIModelId = await IModelTestUtils.getTestIModelId(accessToken, testProjectId, "TestModel");

    testChangeSets = await IModelTestUtils.hubClient.getChangeSets(accessToken, testIModelId, false);
    expect(testChangeSets.length).greaterThan(2);

    const cacheDir = iModelEngine.configuration.briefcaseCacheDir;
    iModelLocalReadonlyPath = path.join(cacheDir, testIModelId, "readOnly");
    iModelLocalReadWritePath = path.join(cacheDir, testIModelId, "readWrite");

    // Delete briefcases if the cache has been cleared, *and* we cannot acquire any more briefcases
    if (!IModelJsFs.existsSync(cacheDir)) {
      await IModelTestUtils.deleteBriefcasesIfAcquireLimitReached(accessToken, "NodeJsTestProject", "TestModel");
      await IModelTestUtils.deleteBriefcasesIfAcquireLimitReached(accessToken, "NodeJsTestProject", "NoVersionsTest");
    }

    console.log(`    ...getting information on Project+IModel+ChangeSets for test case from the Hub: ${new Date().getTime() - startTime} ms`); // tslint:disable-line:no-console
  });

  it("should be able to open an IModel from the Hub in Readonly mode", async () => {
    const iModel: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId, OpenMode.Readonly);
    assert.exists(iModel);
    assert(iModel.iModelToken.openMode === OpenMode.Readonly);

    expect(IModelJsFs.existsSync(iModelLocalReadonlyPath));
    const files = IModelJsFs.readdirSync(iModelLocalReadonlyPath);
    expect(files.length).greaterThan(0);

    iModel.close(accessToken);
  });

  it("should be able to open an IModel from the Hub in ReadWrite mode", async () => {
    const iModel: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId, OpenMode.ReadWrite, IModelVersion.latest()); // Note: No frontend support for ReadWrite open yet
    assert.exists(iModel);
    assert(iModel.iModelToken.openMode === OpenMode.ReadWrite);

    expect(IModelJsFs.existsSync(iModelLocalReadWritePath));
    const files = IModelJsFs.readdirSync(iModelLocalReadWritePath);
    expect(files.length).greaterThan(0);

    iModel.close(accessToken);
  });

  it("should reuse open briefcases in Readonly mode", async () => {
    let timer = new Timer("open briefcase first time");
    const iModel0: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId);
    assert.exists(iModel0);
    timer.end();

    const briefcases = IModelJsFs.readdirSync(iModelLocalReadonlyPath);
    expect(briefcases.length).greaterThan(0);

    timer = new Timer("open briefcase 5 more times");
    const iModels = new Array<IModelDb>();
    for (let ii = 0; ii < 5; ii++) {
      const iModel: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId);
      assert.exists(iModel);
      iModels.push(iModel);
    }
    timer.end();

    const briefcases2 = IModelJsFs.readdirSync(iModelLocalReadonlyPath);
    expect(briefcases2.length).equals(briefcases.length);
    const diff = briefcases2.filter((item) => briefcases.indexOf(item) < 0);
    expect(diff.length).equals(0);
  });

  it("should reuse closed briefcases in ReadWrite mode", async () => {
    const files = IModelJsFs.readdirSync(iModelLocalReadWritePath);

    const iModel: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId, OpenMode.ReadWrite); // Note: No frontend support for ReadWrite open yet
    assert.exists(iModel);

    const files2 = IModelJsFs.readdirSync(iModelLocalReadWritePath);
    expect(files2.length).equals(files.length);
    const diff = files2.filter((item) => files.indexOf(item) < 0);
    expect(diff.length).equals(0);

    iModel.close(accessToken);
  });

  it("should open briefcases of specific versions in Readonly mode", async () => {
    const iModelFirstVersion: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId, OpenMode.Readonly, IModelVersion.first());
    assert.exists(iModelFirstVersion);

    for (const [arrayIndex, versionName] of testVersionNames.entries()) {
      const iModelFromVersion: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId, OpenMode.Readonly, IModelVersion.asOfChangeSet(testChangeSets[arrayIndex].wsgId));
      assert.exists(iModelFromVersion);

      const iModelFromChangeSet: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId, OpenMode.Readonly, IModelVersion.named(versionName));
      assert.exists(iModelFromChangeSet);

      const elementCount = getElementCount(iModelFromVersion);
      assert.equal(elementCount, testElementCounts[arrayIndex]);
    }

    const iModelLatestVersion: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId, OpenMode.Readonly, IModelVersion.latest());
    assert.exists(iModelLatestVersion);
  });

  it("should open a briefcase of an iModel with no versions", async () => {
    const iModelNoVerId = await IModelTestUtils.getTestIModelId(accessToken, testProjectId, "NoVersionsTest");
    const iModelNoVer: IModelDb = await IModelDb.open(accessToken, testProjectId, iModelNoVerId, OpenMode.Readonly);
    assert.exists(iModelNoVer);
  });

  it.skip("should open briefcase of an iModel in both DEV and QA", async () => {
    // Note: This test is commented out since it causes the entire cache to be discarded and is therefore expensive.
    IModelTestUtils.setIModelHubDeployConfig("DEV");
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Turn off SSL validation in DEV
    const devProjectId = await IModelTestUtils.getTestProjectId(accessToken, "NodeJsTestProject");
    assert(devProjectId);
    const devIModelId = await IModelTestUtils.getTestIModelId(accessToken, devProjectId, "MyTestModel");
    assert(devIModelId);
    const devChangeSets: ChangeSet[] = await IModelTestUtils.hubClient.getChangeSets(accessToken, devIModelId, false);
    expect(devChangeSets.length).equals(0); // needs change sets
    const devIModel: IModelDb = await IModelDb.open(accessToken, devProjectId, devIModelId, OpenMode.Readonly, IModelVersion.latest());
    assert.exists(devIModel);

    IModelTestUtils.setIModelHubDeployConfig("QA");
    const qaProjectId = await IModelTestUtils.getTestProjectId(accessToken, "NodeJsTestProject");
    assert(qaProjectId);
    const qaIModelId = await IModelTestUtils.getTestIModelId(accessToken, qaProjectId, "MyTestModel");
    assert(qaIModelId);
    const qaChangeSets: ChangeSet[] = await IModelTestUtils.hubClient.getChangeSets(accessToken, qaIModelId, false);
    expect(qaChangeSets.length).greaterThan(0);
    const qaIModel: IModelDb = await IModelDb.open(accessToken, qaProjectId, qaIModelId, OpenMode.Readonly, IModelVersion.latest());
    assert.exists(qaIModel);
  });

  it("should be able to reverse and reinstate changes", async () => {
    const iModel: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId, OpenMode.Readonly, IModelVersion.latest());

    let arrayIndex: number;
    for (arrayIndex = testVersionNames.length - 1; arrayIndex >= 0; arrayIndex--) {
      await iModel.reverseChanges(accessToken, IModelVersion.named(testVersionNames[arrayIndex]));
      assert.equal(testElementCounts[arrayIndex], getElementCount(iModel));
    }

    await iModel.reverseChanges(accessToken, IModelVersion.first());

    for (arrayIndex = 0; arrayIndex < testVersionNames.length; arrayIndex++) {
      await iModel.reinstateChanges(accessToken, IModelVersion.named(testVersionNames[arrayIndex]));
      assert.equal(testElementCounts[arrayIndex], getElementCount(iModel));
    }

    await iModel.reinstateChanges(accessToken, IModelVersion.latest());
  });

  it("should build concurrency control request", async () => {
    const iModel: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId, OpenMode.ReadWrite);

    const el: Element = iModel.elements.getRootSubject();
    el.buildConcurrencyControlRequest(DbOpcode.Update);    // make a list of the locks, etc. that will be needed to update this element
    const reqAsAny: any = ConcurrencyControl.convertRequestToAny(iModel.concurrencyControl.pendingRequest);
    assert.isDefined(reqAsAny);
    assert.isArray(reqAsAny.Locks);
    assert.equal(reqAsAny.Locks.length, 3, " we expect to need a lock on the element (exclusive), its model (shared), and the db itself (shared)");
    assert.isArray(reqAsAny.Codes);
    assert.equal(reqAsAny.Codes.length, 0, " since we didn't add or change the element's code, we don't expect to need a code reservation");

    iModel.close(accessToken);
  });

  it.skip("should write to briefcase with optimistic concurrency", async () => {
    let timer = new Timer("delete iModels");
    // Delete any existing iModels with the same name as the read-write test iModel
    const iModelName = "ReadWriteTest";
    const iModels: HubIModel[] = await IModelTestUtils.hubClient.getIModels(accessToken, testProjectId, {
      $select: "*",
      $filter: "Name+eq+'" + iModelName + "'",
    });
    for (const iModelTemp of iModels) {
      await IModelTestUtils.hubClient.deleteIModel(accessToken, testProjectId, iModelTemp.wsgId);
    }
    timer.end();

    // Create a new iModel on the Hub (by uploading a seed file)
    timer = new Timer("create iModel");
    const rwIModel: IModelDb = await IModelDb.create(accessToken, testProjectId, "ReadWriteTest", "TestSubject");
    const rwIModelId = rwIModel.iModelToken.iModelId;
    assert.isNotEmpty(rwIModelId);
    timer.end();

    timer = new Timer("make local changes");

    // Turn on optimistic concurrency control. This allows the app to modify elements, models, etc. without first acquiring locks.
    // Later, when the app downloads and merges changeSets from the Hub into the briefcase, BriefcaseManager will merge changes and handle conflicts.
    // The app still has to reserve codes.
    rwIModel.concurrencyControl.setPolicy(new ConcurrencyControl.OptimisticPolicy());

    // Show that we can modify the properties of an element. In this case, we modify the root element itself.
    const rootEl: Element = (rwIModel.elements.getRootSubject()).copyForEdit<Element>();
    rootEl.userLabel = rootEl.userLabel + "changed";
    rwIModel.elements.updateElement(rootEl);

    assert.isFalse(rwIModel.concurrencyControl.hasPendingRequests());

    rwIModel.saveChanges(JSON.stringify({userid: "user1", description: "changed a userLabel"}));  // save it, to show that saveChanges will accumulate local txn descriptions

    // Create a new physical model.
    let newModelId: Id64;
    [, newModelId] = IModelTestUtils.createAndInsertPhysicalModel(rwIModel, IModelTestUtils.getUniqueModelCode(rwIModel, "newPhysicalModel"), true);

    // Find or create a SpatialCategory.
    const dictionary: DictionaryModel = rwIModel.models.getModel(IModel.getDictionaryId()) as DictionaryModel;
    const newCategoryCode = IModelTestUtils.getUniqueSpatialCategoryCode(dictionary, "ThisTestSpatialCategory");
    const spatialCategoryId: Id64 = IModelTestUtils.createAndInsertSpatialCategory(dictionary, newCategoryCode.value!, new Appearance({ color: new ColorDef("rgb(255,0,0)") }));

    timer.end();

    timer = new Timer("query Codes I");

    // iModel.concurrencyControl should have recorded the codes that are required by the new elements.
    assert.isTrue(rwIModel.concurrencyControl.hasPendingRequests());
    assert.isTrue(await rwIModel.concurrencyControl.areAvailable(accessToken));

    timer.end();
    timer = new Timer("reserve Codes");

    // Reserve all of the codes that are required by the new model and category.
    try {
      await rwIModel.concurrencyControl.request(accessToken);
    } catch (err) {
      if (err instanceof ConcurrencyControl.RequestError) {
          assert.fail(JSON.stringify(err.unavailableCodes) + ", " + JSON.stringify(err.unavailableLocks));
      }
    }

    timer.end();
    timer = new Timer("query Codes II");

    // Verify that the codes are reserved.
    const category = rwIModel.elements.getElement(spatialCategoryId);
    assert.isTrue(category.code.value !== undefined);
    const codeStates: MultiCode[] = await rwIModel.concurrencyControl.codes.query(accessToken, category.code.spec, category.code.scope);
    const foundCode: MultiCode[] = codeStates.filter((cs) => cs.values!.includes(category.code.value!) && (cs.state === CodeState.Reserved));
    assert.equal(foundCode.length, 1);

      /* NEEDS WORK - query just this one code
    assert.isTrue(category.code.value !== undefined);
    const codeStates2 = await iModel.concurrencyControl.codes.query(accessToken, category.code.spec, category.code.scope, category.code.value!);
    assert.equal(codeStates2.length, 1);
    assert.equal(codeStates2[0].values.length, 1);
    assert.equal(codeStates2[0].values[0], category.code.value!);
    */

    timer.end();

    timer = new Timer("make more local changes");

    // Create a couple of physical elements.
    const elid1 = rwIModel.elements.insertElement(IModelTestUtils.createPhysicalObject(rwIModel, newModelId, spatialCategoryId));
    rwIModel.elements.insertElement(IModelTestUtils.createPhysicalObject(rwIModel, newModelId, spatialCategoryId));

    // Commit the local changes to a local transaction in the briefcase.
    // (Note that this ends the bulk operation automatically, so there's no need to call endBulkOperation.)
    rwIModel.saveChanges(JSON.stringify({userid: "user1", description: "inserted generic objects"}));

    rwIModel.elements.getElement(elid1); // throws if elid1 is not found
    rwIModel.elements.getElement(spatialCategoryId); // throws if spatialCategoryId is not found

    timer.end();

    timer = new Timer("pullmergepush");

    // Push the changes to the hub
    const prePushChangeSetId = rwIModel.iModelToken.changeSetId;
    await rwIModel.pushChanges(accessToken);
    const postPushChangeSetId = rwIModel.iModelToken.changeSetId;
    assert(!!postPushChangeSetId);
    expect(prePushChangeSetId !== postPushChangeSetId);

    timer.end();

    // Open a readonly copy of the iModel
    const roIModel: IModelDb = await IModelDb.open(accessToken, testProjectId, rwIModelId!, OpenMode.Readonly, IModelVersion.latest());
    assert.exists(roIModel);

    rwIModel.close(accessToken, KeepBriefcase.No);
    roIModel.close(accessToken);
  });

  it.skip("should make change sets", async () => {
    const iModel: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId, OpenMode.ReadWrite);
    assert.exists(iModel);

    const dictionary: DictionaryModel = iModel.models.getModel(IModel.getDictionaryId()) as DictionaryModel;

    let newModelId: Id64;
    [, newModelId] = IModelTestUtils.createAndInsertPhysicalModel(iModel, Code.createEmpty(), true);

    const spatialCategoryId: Id64 = SpatialCategory.create(dictionary, "Cat1").insert();

    // Insert a few elements
    const elements: Element[] = [
      IModelTestUtils.createPhysicalObject(iModel, newModelId, spatialCategoryId),
      IModelTestUtils.createPhysicalObject(iModel, newModelId, spatialCategoryId),
    ];

    for (const el of elements) {
      el.buildConcurrencyControlRequest(DbOpcode.Insert);    // make a list of the resources that will be needed to insert this element (e.g., a shared lock on the model and a code)
    }

    await iModel.concurrencyControl.request(accessToken); // In a pessimistic concurrency regime, we must request locks and codes *before* writing to the local IModelDb.

    for (const el of elements)
      iModel.elements.insertElement(el);

    iModel.saveChanges("inserted generic objects");

    iModel.close(accessToken);
  });

  it("should be able to create a standalone IModel", async () => {
    const iModel: IModelDb = IModelTestUtils.createStandaloneIModel("TestStandalone.bim", "TestSubject");
    iModel.closeStandalone();
  });

  it.only("should test AutoPush", async () => {
    const activityMonitor = {
      isIdle: () => true,
    };

    const iModel: IModelDb = await IModelDb.open(accessToken, testProjectId, testIModelId, OpenMode.ReadWrite);
    iModel.pushChanges = async (_clientAccessToken: AccessToken, _describer?: ChangeSetDescriber): Promise<void> => { lastPushTimeMillis = Date.now(); };
    lastPushTimeMillis = 0;

    const autoPush = new AutoPush(iModel, {pushIntervalSecondsMin: 0, pushIntervalSecondsMax: 10}, accessToken, activityMonitor);
    assert.isTrue(autoPush.isScheduled());
    await new Promise((resolve, _reject)  => { setTimeout(resolve, 100); }); // wait for 1/10 second before checking
    assert.notEqual(lastPushTimeMillis, 0);

    lastPushTimeMillis = 0;

    autoPush.cancel();
    assert.isFalse(autoPush.isScheduled());
    autoPush.scheduleNextAutoPush();
    assert.isTrue(autoPush.isScheduled());

    await new Promise((resolve, _reject)  => { setTimeout(resolve, 100); }); // wait for 1/10 second before checking
    assert.notEqual(lastPushTimeMillis, 0);

  });

});

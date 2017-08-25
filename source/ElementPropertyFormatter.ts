/*---------------------------------------------------------------------------------------------
|  $Copyright: (c) 2017 Bentley Systems, Incorporated. All rights reserved. $
*--------------------------------------------------------------------------------------------*/
import { IModel } from "./IModel";
import { Element } from "./Element";
import { BentleyPromise, BentleyReturn } from "@bentley/bentleyjs-core/lib/Bentley";
import { DbResult } from "@bentley/bentleyjs-core/lib/BeSQLite";
import { assert } from "@bentley/bentleyjs-core/lib/Assert";

/** Base class for all schema classes. */
export class ElementPropertyFormatter {

  private _iModel: IModel;

  /** Construct a formatter
   * @param iModel  The IModel that contains the elements that are to be formatted.
   * *** TBD: Take presentation rules as an argument?
   */
  public constructor(iModel: IModel) { this._iModel = iModel; }

  /**
   * Format the properties of an elemen, suitable for display in a property browser.
   * The returned object will contain the formatted properties, organized according to the presentation rules.
   * For example, the immediate properties may represent categories of properties, where each category object contains the names and values of the proeprties in that category.
   * @param elem        The element to formatName of briefcase to query
   * *** TBD: Take presentation rules as an argument?
   * @return the formatted properties of the element as an anonymous element
   */
  public async formatProperties(elem: Element): BentleyPromise<DbResult, any> {

      // *** NEEDS WORK: We want to format the element's properties right here, using presentation rules.
      // ***             *For now* we must fall back on some hard-coded formatting logic in the native code library.
      // ***             This is a very bad work-around, as it formats the properties of the persistent element in the BIM, not the element passed in!
      const res: BentleyReturn<DbResult, string> = await this._iModel.GetElementPropertiesForDisplay(elem.id.toString());
      if (res.error || undefined === res.result)
        return res;
      const propsObj = JSON.parse(res.result);
      if (undefined === propsObj) {
        assert(false, "tempfmtPropsNative returned invalid JSON on success");
        return Promise.resolve({error: {status: DbResult.BE_SQLITE_ABORT, message: "?"}});
      }

      return Promise.resolve({result: propsObj});
  }

}

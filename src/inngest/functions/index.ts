/**
 * Every workflow this application serves.
 *
 * The serve route registers exactly this list, so a function that is not here does not
 * run — which is the failure worth making obvious in one place rather than discovering
 * through an event that quietly goes nowhere.
 */

import { assessRetrievalFunction } from "./assess-retrieval";
import { identifyRequirementsFunction } from "./identify-requirements";
import { identifyStatementFunction } from "./identify-statement";
import { matchInvoiceFunction } from "./match-invoice";
import { parseStatementFunction } from "./parse-statement";
import { requestRetrievalFunction } from "./request-retrieval";
import { retrieveDocumentsFunction } from "./retrieve-documents";
import { understandDocumentFunction } from "./understand-document";

export const functions = [
  assessRetrievalFunction,
  identifyRequirementsFunction,
  identifyStatementFunction,
  matchInvoiceFunction,
  parseStatementFunction,
  requestRetrievalFunction,
  retrieveDocumentsFunction,
  understandDocumentFunction,
];

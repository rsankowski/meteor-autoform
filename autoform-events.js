function beginSubmit(formId, template) {
  if (!template || template._notInDOM)
    return;
  // Get user-defined hooks
  var hooks = Hooks.getHooks(formId, 'beginSubmit');
  if (hooks.length) {
    _.each(hooks, function beginSubmitHooks(hook) {
      hook(formId, template);
    });
  } else {
    // If there are no user-defined hooks, by default we disable the submit button during submission
    var submitButton = template.find("button[type=submit]") || template.find("input[type=submit]");
    if (submitButton) {
      submitButton.disabled = true;
    }
  }
}

function endSubmit(formId, template) {
  if (!template || template._notInDOM)
    return;
  // Get user-defined hooks
  var hooks = Hooks.getHooks(formId, 'endSubmit');
  if (hooks.length) {
    _.each(hooks, function endSubmitHooks(hook) {
      hook(formId, template);
    });
  } else {
    // If there are no user-defined hooks, by default we disable the submit button during submission
    var submitButton = template.find("button[type=submit]") || template.find("input[type=submit]");
    if (submitButton) {
      submitButton.disabled = false;
    }
  } 
}

Template.autoForm.events({
  'submit form': function autoFormSubmitHandler(event, template) {
    // Gather necessary form info
    var formId = this.id || defaultFormId;
    var data = formData[formId];
    var isInsert = (data.submitType === "insert");
    var isUpdate = (data.submitType === "update");
    var isRemove = (data.submitType === "remove");
    var isMethod = (data.submitType === "method");
    var method = data.submitMethod;
    var isNormalSubmit = (!isInsert && !isUpdate && !isRemove && !isMethod);
    // ss will be the schema for the `schema` attribute if present,
    // else the schema for the collection
    var ss = data.ss;
    var collection = data.collection;
    var currentDoc = data.doc;
    var docId = currentDoc ? currentDoc._id : null;
    var resetOnSuccess = data.resetOnSuccess;

    // Make sure we have a collection if we need one for the requested submit type
    if (!collection) {
      if (isInsert)
        throw new Error("AutoForm: You must specify a collection when form type is insert.");
      else if (isUpdate)
        throw new Error("AutoForm: You must specify a collection when form type is update.");
      else if (isRemove)
        throw new Error("AutoForm: You must specify a collection when form type is remove.");
    }

    // Prevent browser form submission if we're planning to do our own thing
    if (!isNormalSubmit) {
      event.preventDefault();
    }

    // Gather hooks
    var onSuccess = Hooks.getHooks(formId, 'onSuccess');
    var onError = Hooks.getHooks(formId, 'onError');

    // Prep haltSubmission function
    function haltSubmission() {
      event.preventDefault();
      event.stopPropagation();
      // Run endSubmit hooks (re-enabled submit button or form, etc.)
      endSubmit(formId, template);
    }

    // Prep callback creator function
    function makeCallback(name) {
      var afterHooks = Hooks.getHooks(formId, 'after', name);
      return function autoFormActionCallback(error, result) {
        if (error) {
          preventQueuedValidation();
          selectFirstInvalidField(formId, ss, template);
          _.each(onError, function onErrorEach(hook) {
            hook(name, error, template);
          });
        } else {
          // By default, we reset form after successful submit, but
          // you can opt out.
          if (resetOnSuccess !== false) {
            AutoForm.resetForm(formId, template);
          }
          _.each(onSuccess, function onSuccessEach(hook) {
            hook(name, result, template);
          });
        }
        _.each(afterHooks, function afterHooksEach(hook) {
          hook(error, result, template);
        });
        // Run endSubmit hooks (re-enabled submit button or form, etc.)
        endSubmit(formId, template);
      };
    }

    // Prep function that calls before hooks.
    // We pass the template instance in case the hook
    // needs the data context.
    function doBefore(docId, doc, hooks, name, next) {
      // We call the hooks recursively, in order added,
      // passing the result of the first hook to the
      // second hook, etc.
      function runHook(i, doc) {
        hook = hooks[i];

        if (!hook) {
          // We've run all hooks; continue submission
          next(doc);
          return;
        }

        // Set up before hook context
        var cb = function (d) {
          // If the hook returns false, we cancel
          if (d === false) {
            // Run endSubmit hooks (re-enabled submit button or form, etc.)
            endSubmit(formId, template);
          } else {
            if (!_.isObject(d)) {
              throw new Error(name + " must return an object");
            }
            runHook(i+1, d);
          }
        };
        var ctx = {
          result: _.once(cb)
        };

        var result;
        if (docId) {
          result = hook.call(ctx, docId, doc, template);
        } else {
          result = hook.call(ctx, doc, template);
        }
        // If the hook returns undefined, we wait for it
        // to call this.result()
        if (result !== void 0) {
          ctx.result(result);
        }
      }
      
      runHook(0, doc);
    }

    // Prep function that calls onSubmit hooks.
    // We pass the template instance in case the hook
    // needs the data context, and event in case they
    // need to prevent default, etc.
    function doOnSubmit(hooks, insertDoc, updateDoc, currentDoc) {
      // These are called differently from the before hooks because
      // they run async, but they can run in parallel and we need the
      // result of all of them immediately because they can return
      // false to stop normal form submission.

      var hookCount = hooks.length, doneCount = 0;

      if (hookCount === 0) {
        // Run endSubmit hooks (re-enabled submit button or form, etc.)
        endSubmit(formId, template);
        return;
      }

      // Set up before hook context
      var ctx = {
        event: event,
        template: template,
        resetForm: function () {
          AutoForm.resetForm(formId, template);
        },
        done: function () {
          doneCount++;
          console.log(doneCount, hookCount);
          if (doneCount === hookCount) {
            // Run endSubmit hooks (re-enabled submit button or form, etc.)
            endSubmit(formId, template);
          }
        }
      };

      // Call all hooks at once.
      // Pass both types of doc plus the doc attached to the form.
      // If any return false, we stop normal submission, but we don't
      // run endSubmit hooks until they all call this.done().
      var shouldStop = false;
      _.each(hooks, function eachOnSubmit(hook) {
        var result = hook.call(ctx, insertDoc, updateDoc, currentDoc);
        if (shouldStop === false && result === false) {
          shouldStop = true;
        }
      });
      if (shouldStop) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    // If type is "remove", do that right away since we don't need to gather
    // form values or validate.
    if (isRemove) {
      // Run beginSubmit hooks (disable submit button or form, etc.)
      beginSubmit(formId, template);

      // Call beforeRemove hooks if present, and stop if any return false
      var beforeRemove = Hooks.getHooks(formId, 'before', 'remove');
      var shouldStop = _.any(beforeRemove, function eachBeforeRemove(hook) {
        return (hook(docId, template) === false);
      });
      if (shouldStop) {
        return haltSubmission();
      }
      var removeCallback = makeCallback('remove');
      collection.remove(docId, removeCallback);
      return;
    }

    // Validate, which also gets form values.
    // We do this even if inserting or updating, which have their
    // own validation, because this validates against the form
    // `schema` whereas insert/update validate against the `collection`
    // schema, and they are sometimes different.
    var results = _validateForm(formId, template);

    // If we failed pre-submit validation, we stop submission.
    if (results.insertDocIsValid === false) {
      selectFirstInvalidField(formId, ss, template);
      _.each(onError, function onErrorEach(hook) {
        hook('pre-submit validation', new Error('form failed validation'), template);
      });
      return haltSubmission();
    }

    var insertDoc = results.insertDoc;
    var updateDoc = results.updateDoc;

    // Run beginSubmit hooks (disable submit button or form, etc.)
    // NOTE: This needs to stay after getFormValues in case a
    // beginSubmit hook disables inputs. We don't get values for
    // disabled inputs, but if they are just disabling during submission,
    // then we actually do want the values.
    beginSubmit(formId, template);

    // Now we will do the requested insert, update, remove, method, or normal
    // browser form submission. Even though we may have already validated above,
    // we do it again upon insert or update
    // because collection2 validation catches additional stuff like unique and
    // because our form schema need not be the same as our collection schema.

    // INSERT FORM SUBMIT
    if (isInsert) {
      // Get "before.insert" hooks
      var beforeInsertHooks = Hooks.getHooks(formId, 'before', 'insert');
      // Run "before.insert" hooks
      doBefore(null, insertDoc, beforeInsertHooks, 'before.insert hook', function (doc) {
        // Make callback for insert
        var insertCallback = makeCallback('insert');
        // Perform insert
        collection.insert(doc, {validationContext: formId}, insertCallback);
      });
    }

    // UPDATE FORM SUBMIT
    else if (isUpdate) {
      // Get "before.update" hooks
      var beforeUpdateHooks = Hooks.getHooks(formId, 'before', 'update');
      // Run "before.update" hooks
      doBefore(docId, updateDoc, beforeUpdateHooks, 'before.update hook', function (modifier) {
        // Make callback for update
        var updateCallback = makeCallback('update');
        if (_.isEmpty(modifier)) { // make sure this check stays after the before hooks
          // Nothing to update. Just treat it as a successful update.
          updateCallback(null, 0);
        }
        // Perform update
        collection.update(docId, modifier, {validationContext: formId}, updateCallback);
      });
    }

    // METHOD FORM SUBMIT
    else if (isMethod) {
      // Get "before.methodName" hooks
      var beforeMethodHooks = Hooks.getHooks(formId, 'before', method);
      // Run "before.methodName" hooks
      doBefore(null, insertDoc, beforeMethodHooks, 'before.method hook', function (doc) {
        // Make callback for Meteor.call
        var methodCallback = makeCallback(method);
        // Call the method
        Meteor.call(method, doc, updateDoc, docId, methodCallback);
      });
    }

    // NORMAL FORM SUBMIT
    else if (isNormalSubmit) {
      // Get onSubmit hooks
      var onSubmitHooks = Hooks.getHooks(formId, 'onSubmit');
      doOnSubmit(onSubmitHooks, insertDoc, updateDoc, currentDoc);
    }
  },
  'keyup [data-schema-key]': function autoFormKeyUpHandler(event, template) {
    var validationType = template.data.validation || 'submitThenKeyup';
    var onlyIfAlreadyInvalid = (validationType === 'submitThenKeyup');
    var skipEmpty = !(event.keyCode === 8 || event.keyCode === 46); //if deleting or backspacing, don't skip empty
    if ((validationType === 'keyup' || validationType === 'submitThenKeyup')) {
      validateField(event.currentTarget.getAttribute("data-schema-key"), template, skipEmpty, onlyIfAlreadyInvalid);
    }
  },
  'blur [data-schema-key]': function autoFormBlurHandler(event, template) {
    var validationType = template.data.validation || 'submitThenKeyup';
    var onlyIfAlreadyInvalid = (validationType === 'submitThenKeyup' || validationType === 'submitThenBlur');
    if (validationType === 'keyup' || validationType === 'blur' || validationType === 'submitThenKeyup' || validationType === 'submitThenBlur') {
      validateField(event.currentTarget.getAttribute("data-schema-key"), template, false, onlyIfAlreadyInvalid);
    }
  },
  'change form': function autoFormChangeHandler(event, template) {
    var key = event.target.getAttribute("data-schema-key");
    if (!key)
      return;

    var formId = this.id;
    var data = formData[formId];
    if (data && data.ss) {
      var ss = data.ss;
      formPreserve.registerForm(formId, function autoFormRegFormCallback() {
        return getFormValues(template, formId, ss).insertDoc;
      });

      // Get field's value for reactive show/hide of other fields by value
      updateTrackedFieldValue(formId, key, getFieldValue(template, key));
    }
    var validationType = data.validationType || 'submitThenKeyup';
    var onlyIfAlreadyInvalid = (validationType === 'submitThenKeyup' || validationType === 'submitThenBlur');
    if (validationType === 'keyup' || validationType === 'blur' || validationType === 'submitThenKeyup' || validationType === 'submitThenBlur') {
      validateField(key, template, false, onlyIfAlreadyInvalid);
    }
  },
  'reset form': function autoFormResetHandler(event, template) {
    var formId = this.id || defaultFormId;

    formPreserve.unregisterForm(formId);

    // Reset array counts
    arrayTracker.resetForm(formId);

    var fd = formData[formId];

    if (!fd)
      return;

    if (fd.ss) {
      fd.ss.namedContext(formId).resetValidation();
      // If simpleSchema is undefined, we haven't yet rendered the form, and therefore
      // there is no need to reset validation for it. No error need be thrown.
    }

    //XXX We should ideally be able to call invalidateFormContext
    // in all cases and that's it, but we need to figure out how
    // to make Blaze forget about any changes the user made to the form
    if (this.doc) {
      event.preventDefault();
      invalidateFormContext(formId);
      template.$("[autofocus]").focus();
    } else {
      // Update tracked field values
      // This must be done after we allow this event handler to return
      // because we have to let the browser reset all fields before we
      // update their values for deps.
      Meteor.setTimeout(function () {
        updateAllTrackedFieldValues(formId);
        if (template && !template._notInDOM) {
          template.$("[autofocus]").focus();
        }
      }, 0);
    }

  },
  'keydown .autoform-array-item input': function (event, template) {
    // When enter is pressed in an array item field, default behavior
    // seems to be to "click" the remove item button. This doesn't make
    // sense so we stop it.
    if (event.keyCode === 13) {
      event.preventDefault();
    }
  },
  'click .autoform-remove-item': function autoFormClickRemoveItem(event, template) {
    var self = this; // This type of button must be used within an afEachArrayItem block, so we know the context

    event.preventDefault();

    var name = self.arrayFieldName;
    var minCount = self.minCount; // optional, overrides schema
    var maxCount = self.maxCount; // optional, overrides schema
    var index = self.index;
    var data = template.data;
    var formId = data && data.id || defaultFormId;
    var ss = formData[formId].ss;

    // remove the item we clicked
    arrayTracker.removeFromFieldAtIndex(formId, name, index, ss, minCount, maxCount);
  },
  'click .autoform-add-item': function autoFormClickAddItem(event, template) {
    event.preventDefault();

    // We pull from data attributes because the button could be manually
    // added anywhere, so we don't know the data context.
    var btn = $(event.currentTarget);
    var name = btn.attr("data-autoform-field");
    var minCount = btn.attr("data-autoform-minCount"); // optional, overrides schema
    var maxCount = btn.attr("data-autoform-maxCount"); // optional, overrides schema
    var data = template.data;
    var formId = data && data.id || defaultFormId;
    var ss = formData[formId].ss;

    arrayTracker.addOneToField(formId, name, ss, minCount, maxCount);
  }
});